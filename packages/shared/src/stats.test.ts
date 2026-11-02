import { describe, expect, it } from 'vitest';
import { deltaStats, type StatsSample } from './index';

function sample(patch: Partial<StatsSample> = {}): StatsSample {
  return {
    timestamp: 1000,
    bytesSent: 100,
    bytesReceived: 200,
    packetsLost: 10,
    packetsReceived: 20,
    jitter: null,
    currentRoundTripTime: null,
    framesDecoded: 30,
    localCandidateType: null,
    ...patch,
  };
}

describe('deltaStats', () => {
  it('converts one second of counter deltas and the current latency samples', () => {
    const previous = Object.freeze(sample());
    const next = Object.freeze(
      sample({
        timestamp: 2000,
        bytesSent: 225,
        bytesReceived: 450,
        packetsLost: 12,
        packetsReceived: 28,
        jitter: 0.02,
        currentRoundTripTime: 0.05,
        framesDecoded: 54,
        localCandidateType: 'host',
      }),
    );
    expect(deltaStats(previous, next)).toEqual({
      outboundBitrate: 1000,
      inboundBitrate: 2000,
      packetLossPercent: 20,
      jitterMs: 20,
      roundTripTimeMs: 50,
      framesPerSecond: 24,
      iceType: 'host',
    });
  });

  it('leaves first-sample deltas null while showing current latency and ICE', () => {
    expect(deltaStats(null, sample({ jitter: 0.02, localCandidateType: 'relay' }))).toEqual({
      outboundBitrate: null,
      inboundBitrate: null,
      packetLossPercent: null,
      jitterMs: 20,
      roundTripTimeMs: null,
      framesPerSecond: null,
      iceType: 'relay',
    });
  });

  it.each([1000, 500, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns null rates for a nonpositive interval ending at %s',
    (timestamp) => {
      const view = deltaStats(
        sample(),
        sample({
          timestamp,
          bytesSent: 225,
          framesDecoded: 54,
          packetsLost: 12,
          packetsReceived: 28,
        }),
      );
      expect(view.outboundBitrate).toBeNull();
      expect(view.inboundBitrate).toBeNull();
      expect(view.framesPerSecond).toBeNull();
      expect(view.packetLossPercent).toBeNull();
    },
  );

  it('scales rates by the elapsed seconds', () => {
    const view = deltaStats(
      sample(),
      sample({ timestamp: 3000, bytesSent: 350, framesDecoded: 78 }),
    );
    expect(view.outboundBitrate).toBe(1000);
    expect(view.framesPerSecond).toBe(24);
  });

  it.each([
    ['bytesSent', 'outboundBitrate'],
    ['bytesReceived', 'inboundBitrate'],
    ['framesDecoded', 'framesPerSecond'],
  ] as const)('returns null for missing or backward %s counters', (counter, field) => {
    expect(deltaStats(sample({ [counter]: null }), sample({ timestamp: 2000 }))[field]).toBeNull();
    expect(deltaStats(sample(), sample({ timestamp: 2000, [counter]: null }))[field]).toBeNull();
    expect(deltaStats(sample(), sample({ timestamp: 2000, [counter]: 0 }))[field]).toBeNull();
  });

  it('reports zero for unchanged byte and frame counters over a positive interval', () => {
    const view = deltaStats(sample(), sample({ timestamp: 2000 }));
    expect(view.outboundBitrate).toBe(0);
    expect(view.inboundBitrate).toBe(0);
    expect(view.framesPerSecond).toBe(0);
  });

  it('returns null loss when no packets arrived', () => {
    expect(deltaStats(sample(), sample({ timestamp: 2000 })).packetLossPercent).toBeNull();
  });

  it.each(['packetsLost', 'packetsReceived'] as const)(
    'returns null loss for missing or backward %s counters',
    (counter) => {
      const next = sample({ timestamp: 2000, packetsLost: 12, packetsReceived: 28 });
      expect(deltaStats(sample({ [counter]: null }), next).packetLossPercent).toBeNull();
      expect(deltaStats(sample(), { ...next, [counter]: null }).packetLossPercent).toBeNull();
      expect(deltaStats(sample(), { ...next, [counter]: 0 }).packetLossPercent).toBeNull();
    },
  );

  it('reports zero loss when received packets have no losses', () => {
    expect(
      deltaStats(sample(), sample({ timestamp: 2000, packetsReceived: 28 })).packetLossPercent,
    ).toBe(0);
  });

  it('keeps missing current latency samples null', () => {
    const view = deltaStats(sample({ jitter: 0.02, currentRoundTripTime: 0.05 }), sample());
    expect(view.jitterMs).toBeNull();
    expect(view.roundTripTimeMs).toBeNull();
  });

  it.each(['host', 'srflx', 'relay'] as const)(
    'preserves the %s ICE type',
    (localCandidateType) => {
      expect(deltaStats(null, sample({ localCandidateType })).iceType).toBe(localCandidateType);
    },
  );

  it.each(['prflx', null, 'other'])('maps ICE type %s to unknown', (localCandidateType) => {
    expect(deltaStats(null, sample({ localCandidateType })).iceType).toBe('unknown');
  });
});
