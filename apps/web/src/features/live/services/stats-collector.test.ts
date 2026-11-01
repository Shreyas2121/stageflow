import { afterEach, describe, expect, it, vi } from 'vitest';
import { deltaStats } from '@stageflow/shared';
import type { PeerStatsSource } from './peer-manager';
import { StatsCollector, statsSample } from './stats-collector';

type Entry = { id: string; type: string; [key: string]: unknown };

function report(entries: Entry[], timestamp = 1000): RTCStatsReport {
  return new Map(entries.map((entry) => [entry.id, { timestamp, ...entry }]));
}

function rtpReport(timestamp: number, bytes: number): RTCStatsReport {
  return report(
    [
      { id: 'out', type: 'outbound-rtp', kind: 'video', bytesSent: bytes },
      { id: 'in', type: 'inbound-rtp', kind: 'video', bytesReceived: bytes, framesDecoded: bytes },
    ],
    timestamp,
  );
}

afterEach(() => vi.useRealTimers());

describe('statsSample', () => {
  it('sums local RTP counters without double-counting candidate or remote reports', () => {
    const sample = statsSample(
      report([
        { id: 'out-audio', type: 'outbound-rtp', kind: 'audio', bytesSent: 25 },
        { id: 'out-video', type: 'outbound-rtp', kind: 'video', bytesSent: 100, framesEncoded: 99 },
        {
          id: 'in-video',
          type: 'inbound-rtp',
          kind: 'video',
          bytesReceived: 200,
          packetsLost: 2,
          packetsReceived: 6,
          framesDecoded: 24,
          jitter: 0.04,
        },
        {
          id: 'in-audio',
          type: 'inbound-rtp',
          kind: 'audio',
          bytesReceived: 50,
          packetsLost: 0,
          packetsReceived: 2,
          jitter: 0.02,
        },
        { id: 'remote-in', type: 'remote-inbound-rtp', bytesReceived: 9999, packetsLost: 99 },
        { id: 'remote-out', type: 'remote-outbound-rtp', bytesSent: 9999 },
        {
          id: 'pair',
          type: 'candidate-pair',
          nominated: true,
          state: 'succeeded',
          bytesSent: 9999,
          bytesReceived: 9999,
          currentRoundTripTime: 0.05,
          localCandidateId: 'local',
        },
        { id: 'local', type: 'local-candidate', candidateType: 'host' },
      ]),
    );
    expect(sample).toEqual({
      timestamp: 1000,
      bytesSent: 125,
      bytesReceived: 250,
      packetsLost: 2,
      packetsReceived: 8,
      jitter: 0.02,
      currentRoundTripTime: 0.05,
      framesDecoded: 24,
      localCandidateType: 'host',
    });
  });

  it('falls back to video jitter and preserves missing counters as null', () => {
    const sample = statsSample(
      report([
        { id: 'audio', type: 'inbound-rtp', kind: 'audio' },
        { id: 'video', type: 'inbound-rtp', kind: 'video', jitter: 0.03, framesDecoded: 0 },
      ]),
    );
    expect(sample).toEqual({
      timestamp: 1000,
      bytesSent: null,
      bytesReceived: null,
      packetsLost: null,
      packetsReceived: null,
      jitter: 0.03,
      currentRoundTripTime: null,
      framesDecoded: 0,
      localCandidateType: null,
    });
    expect(statsSample(report([])).jitter).toBeNull();
  });

  it('prefers the transport-selected nominated pair and ignores pending pairs', () => {
    const entries: Entry[] = [
      {
        id: 'old',
        type: 'candidate-pair',
        nominated: true,
        state: 'succeeded',
        localCandidateId: 'host',
        currentRoundTripTime: 0.1,
      },
      {
        id: 'pending',
        type: 'candidate-pair',
        nominated: true,
        state: 'in-progress',
        localCandidateId: 'host',
      },
      {
        id: 'selected',
        type: 'candidate-pair',
        nominated: true,
        state: 'succeeded',
        localCandidateId: 'relay',
        currentRoundTripTime: 0.02,
      },
      { id: 'host', type: 'local-candidate', candidateType: 'host' },
      { id: 'relay', type: 'local-candidate', candidateType: 'relay' },
      { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' },
    ];
    expect(statsSample(report(entries))).toMatchObject({
      currentRoundTripTime: 0.02,
      localCandidateType: 'relay',
    });
    const pendingOnly = entries.filter(
      (entry) => entry.id === 'pending' || entry.type === 'local-candidate',
    );
    expect(statsSample(report(pendingOnly))).toMatchObject({
      currentRoundTripTime: null,
      localCandidateType: null,
    });
  });
});

describe('StatsCollector', () => {
  it('publishes first-sample nulls, polls once a second, and stops on close', async () => {
    vi.useFakeTimers();
    const getStats = vi
      .fn()
      .mockResolvedValueOnce(rtpReport(1000, 0))
      .mockResolvedValue(rtpReport(2000, 24));
    const publish = vi.fn();
    const collector = new StatsCollector(() => [{ socketId: 'peer', getStats }], publish);
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.lastCall?.[0].get('peer')).toMatchObject({
      inboundBitrate: null,
      framesPerSecond: null,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(getStats).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(publish.mock.lastCall?.[0].get('peer')).toMatchObject({
      inboundBitrate: 192,
      outboundBitrate: 192,
      framesPerSecond: 24,
    });
    collector.close();
    collector.close();
    await vi.advanceTimersByTimeAsync(3000);
    expect(getStats).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops removed rows and starts a fresh baseline for a returning connection', async () => {
    vi.useFakeTimers();
    const getStats = vi.fn().mockResolvedValue(rtpReport(1000, 10));
    let sources: readonly PeerStatsSource[] = [{ socketId: 'peer', getStats }];
    const publish = vi.fn();
    const collector = new StatsCollector(() => sources, publish);
    await vi.advanceTimersByTimeAsync(0);
    sources = [];
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish.mock.lastCall?.[0].size).toBe(0);
    sources = [{ socketId: 'peer', getStats }];
    getStats.mockResolvedValue(rtpReport(3000, 100));
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish.mock.lastCall?.[0].get('peer').inboundBitrate).toBeNull();
    collector.close();
  });

  it('clears stale values on failure without blocking other connections', async () => {
    vi.useFakeTimers();
    const failing = vi
      .fn()
      .mockResolvedValueOnce(rtpReport(1000, 0))
      .mockRejectedValueOnce(new Error('Connection closed'))
      .mockResolvedValue(rtpReport(3000, 48));
    const healthy = vi
      .fn()
      .mockResolvedValueOnce(rtpReport(1000, 0))
      .mockResolvedValue(rtpReport(2000, 24));
    const publish = vi.fn();
    const collector = new StatsCollector(
      () => [
        { socketId: 'failing', getStats: failing },
        { socketId: 'healthy', getStats: healthy },
      ],
      publish,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish.mock.lastCall?.[0].get('failing')).toEqual(
      deltaStats(null, statsSample(report([]))),
    );
    expect(publish.mock.lastCall?.[0].get('healthy').inboundBitrate).toBe(192);
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish.mock.lastCall?.[0].get('failing').inboundBitrate).toBeNull();
    collector.close();
  });

  it('avoids overlapping requests and ignores results after close', async () => {
    vi.useFakeTimers();
    let resolve!: (report: RTCStatsReport) => void;
    const getStats = vi.fn(
      () =>
        new Promise<RTCStatsReport>((done) => {
          resolve = done;
        }),
    );
    const publish = vi.fn();
    const collector = new StatsCollector(() => [{ socketId: 'peer', getStats }], publish);
    await vi.advanceTimersByTimeAsync(2000);
    expect(getStats).toHaveBeenCalledOnce();
    collector.close();
    resolve(rtpReport(1000, 0));
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
