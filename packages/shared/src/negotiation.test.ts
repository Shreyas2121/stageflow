import { describe, expect, it } from 'vitest';
import { canRelay, meshPeers, reduceNegotiation, type NegotiationFlags } from './negotiation';

function flags(patch: Partial<NegotiationFlags> = {}): NegotiationFlags {
  return {
    polite: false,
    makingOffer: false,
    ignoreOffer: false,
    isSettingRemoteAnswerPending: false,
    signalingState: 'stable',
    remoteDescriptionSet: false,
    ...patch,
  };
}

const offer = { type: 'description', description: { type: 'offer' } } as const;

describe('reduceNegotiation', () => {
  it('ignores glare for an impolite peer without changing other flags', () => {
    const current = Object.freeze(flags({ makingOffer: true, signalingState: 'have-local-offer' }));
    expect(reduceNegotiation(current, offer)).toEqual({
      flags: { ...current, ignoreOffer: true },
      action: 'ignore-description',
    });
    expect(current.ignoreOffer).toBe(false);
  });

  it('accepts glare for a polite peer', () => {
    const current = flags({ polite: true, makingOffer: true, signalingState: 'have-local-offer' });
    expect(reduceNegotiation(current, offer)).toEqual({
      flags: { ...current, remoteDescriptionSet: true },
      action: 'accept-offer',
    });
  });

  it('accepts a non-colliding offer and clears an earlier ignore', () => {
    expect(reduceNegotiation(flags({ ignoreOffer: true }), offer)).toEqual({
      flags: flags({ remoteDescriptionSet: true }),
      action: 'accept-offer',
    });
  });

  it('allows an offer during a pending remote answer unless still making an offer', () => {
    const current = flags({
      signalingState: 'have-local-offer',
      isSettingRemoteAnswerPending: true,
    });
    expect(reduceNegotiation(current, offer).action).toBe('accept-offer');
    expect(reduceNegotiation({ ...current, makingOffer: true }, offer).action).toBe(
      'ignore-description',
    );
    expect(reduceNegotiation(flags({ makingOffer: true }), offer).action).toBe(
      'ignore-description',
    );
    expect(reduceNegotiation(flags({ signalingState: 'have-local-offer' }), offer).action).toBe(
      'ignore-description',
    );
  });

  it('sends one offer, suppresses the next request, and clears makingOffer when finished', () => {
    const first = reduceNegotiation(Object.freeze(flags()), { type: 'negotiation-needed' });
    expect(first).toEqual({ flags: flags({ makingOffer: true }), action: 'send-offer' });
    expect(reduceNegotiation(first.flags, { type: 'negotiation-needed' })).toEqual({
      flags: first.flags,
      action: 'none',
    });
    expect(reduceNegotiation(first.flags, { type: 'local-offer-finished' })).toEqual({
      flags: flags(),
      action: 'none',
    });
  });

  it.each([
    'have-local-offer',
    'have-remote-offer',
    'have-local-pranswer',
    'have-remote-pranswer',
    'closed',
  ] as const)('does not send an offer in %s', (signalingState) => {
    const current = flags({ signalingState });
    expect(reduceNegotiation(current, { type: 'negotiation-needed' })).toEqual({
      flags: current,
      action: 'none',
    });
  });

  it('queues candidates in arrival order and applies them only after accepting a description', () => {
    let current = flags();
    const queued: string[] = [];
    const applied: string[] = [];
    for (const candidate of ['first', 'second']) {
      const result = reduceNegotiation(current, { type: 'candidate' });
      expect(result.action).toBe('queue-candidate');
      current = result.flags;
      queued.push(candidate);
    }
    expect(applied).toEqual([]);
    const accepted = reduceNegotiation(current, offer);
    expect(accepted.action).toBe('accept-offer');
    current = accepted.flags;
    for (const candidate of queued.splice(0)) {
      expect(reduceNegotiation(current, { type: 'candidate' }).action).toBe('add-candidate');
      applied.push(candidate);
    }
    expect(applied).toEqual(['first', 'second']);
    expect(queued).toEqual([]);
  });

  it.each([false, true])(
    'drops candidates after ignoring an offer (remote description set: %s)',
    (remoteDescriptionSet) => {
      const ignored = reduceNegotiation(flags({ makingOffer: true, remoteDescriptionSet }), offer);
      const queued: string[] = [];
      const result = reduceNegotiation(ignored.flags, { type: 'candidate' });
      if (result.action === 'queue-candidate') queued.push('ignored');
      expect(result).toEqual({ flags: ignored.flags, action: 'drop-candidate' });
      expect(queued).toEqual([]);
    },
  );

  it('accepts an answer, clears ignore, and allows subsequent candidates', () => {
    const current = flags({ signalingState: 'have-local-offer', ignoreOffer: true });
    const accepted = reduceNegotiation(current, {
      type: 'description',
      description: { type: 'answer' },
    });
    expect(accepted).toEqual({
      flags: { ...current, ignoreOffer: false, remoteDescriptionSet: true },
      action: 'accept-answer',
    });
    expect(reduceNegotiation(accepted.flags, { type: 'candidate' }).action).toBe('add-candidate');
  });
});

describe('stage mesh and relay', () => {
  const stage = Object.freeze(['host', 'speaker', 'other']);

  it('removes self, preserves stage order, and gives attendees no peers', () => {
    expect(meshPeers('speaker', stage)).toEqual(['host', 'other']);
    expect(meshPeers('attendee', stage)).toEqual([]);
    expect(meshPeers('host', ['host'])).toEqual([]);
    expect(meshPeers('host', [])).toEqual([]);
  });

  it('permits relay only between different stage members', () => {
    expect(canRelay(stage, 'host', 'speaker')).toBe(true);
    expect(canRelay(stage, 'speaker', 'host')).toBe(true);
    expect(canRelay(stage, 'attendee', 'host')).toBe(false);
    expect(canRelay(stage, 'host', 'attendee')).toBe(false);
    expect(canRelay(stage, 'host', 'missing')).toBe(false);
    expect(canRelay(stage, 'host', 'host')).toBe(false);
    expect(canRelay([], 'host', 'speaker')).toBe(false);
  });
});
