import { afterEach, describe, expect, it, vi } from 'vitest';
import { deltaStats } from '@stageflow/shared';
import type { PeerStatsSource } from './peer-manager';
import { StatsCollector, statsSample, STATS_READ_TIMEOUT_MS } from './stats-collector';

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
  it('bounds one never-resolving peer while healthy rows keep their one-second cadence', async () => {
    vi.useFakeTimers();
    const stalled = vi.fn(() => new Promise<RTCStatsReport>(() => {}));
    let count = 0;
    const healthy = vi.fn(async () => {
      count++;
      return rtpReport(count * 1000, count * 24);
    });
    const publish = vi.fn();
    const collector = new StatsCollector(
      () => [
        { participantId: 'stalled', identity: stalled, getStats: stalled },
        { participantId: 'healthy', identity: healthy, getStats: healthy },
      ],
      publish,
    );
    await vi.advanceTimersByTimeAsync(STATS_READ_TIMEOUT_MS - 1);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(publish.mock.lastCall?.[0].get('stalled')).toEqual(
      deltaStats(null, statsSample(report([]))),
    );
    await vi.advanceTimersByTimeAsync(6000 - STATS_READ_TIMEOUT_MS);
    expect(stalled).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledTimes(7);
    expect(publish).toHaveBeenCalledTimes(7);
    expect(publish.mock.lastCall?.[0].get('healthy').inboundBitrate).toBe(192);
    collector.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores an expired result and uses a fresh baseline when that peer becomes readable again', async () => {
    vi.useFakeTimers();
    let resolve!: (value: RTCStatsReport) => void;
    const getStats = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<RTCStatsReport>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce(rtpReport(3000, 10))
      .mockResolvedValue(rtpReport(4000, 34));
    const publish = vi.fn();
    const collector = new StatsCollector(
      () => [{ participantId: 'peer', identity: getStats, getStats }],
      publish,
    );
    await vi.advanceTimersByTimeAsync(1200);
    const calls = publish.mock.calls.length;
    resolve(rtpReport(1000, 999));
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(800);
    expect(publish.mock.lastCall?.[0].get('peer').inboundBitrate).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish.mock.lastCall?.[0].get('peer').inboundBitrate).toBe(192);
    collector.close();
  });

  it('rejects results from a replaced connection even when the socket ID is reused', async () => {
    vi.useFakeTimers();
    let resolve!: (value: RTCStatsReport) => void;
    const oldRead = vi.fn(
      () =>
        new Promise<RTCStatsReport>((done) => {
          resolve = done;
        }),
    );
    const newRead = vi
      .fn()
      .mockResolvedValueOnce(rtpReport(2000, 100))
      .mockResolvedValue(rtpReport(3000, 124));
    let sources: PeerStatsSource[] = [
      { participantId: 'peer', identity: oldRead, getStats: oldRead },
    ];
    const publish = vi.fn();
    const collector = new StatsCollector(() => sources, publish);
    await vi.advanceTimersByTimeAsync(10);
    sources = [{ participantId: 'peer', identity: newRead, getStats: newRead }];
    resolve(rtpReport(1000, 0));
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.lastCall?.[0].size).toBe(0);
    await vi.advanceTimersByTimeAsync(990);
    expect(publish.mock.lastCall?.[0].get('peer').inboundBitrate).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish.mock.lastCall?.[0].get('peer').inboundBitrate).toBe(192);
    collector.close();
  });

  it('closes during await and reopens without overlapping or accepting the old native read', async () => {
    vi.useFakeTimers();
    let resolve!: (value: RTCStatsReport) => void;
    const getStats = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<RTCStatsReport>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce(rtpReport(2000, 100))
      .mockResolvedValue(rtpReport(3000, 124));
    const sources = () => [{ participantId: 'peer', identity: getStats, getStats }];
    const oldPublish = vi.fn(),
      newPublish = vi.fn();
    const old = new StatsCollector(sources, oldPublish);
    await vi.advanceTimersByTimeAsync(50);
    old.close();
    const next = new StatsCollector(sources, newPublish);
    await vi.advanceTimersByTimeAsync(0);
    expect(oldPublish).not.toHaveBeenCalled();
    expect(getStats).toHaveBeenCalledOnce();
    resolve(rtpReport(1000, 999));
    await vi.advanceTimersByTimeAsync(0);
    expect(oldPublish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(newPublish.mock.lastCall?.[0].get('peer').inboundBitrate).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(newPublish.mock.lastCall?.[0].get('peer').inboundBitrate).toBe(192);
    next.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does no hidden work after close and starts rates over when reopened', async () => {
    vi.useFakeTimers();
    const getStats = vi
      .fn()
      .mockResolvedValueOnce(rtpReport(1000, 0))
      .mockResolvedValueOnce(rtpReport(2000, 24))
      .mockResolvedValueOnce(rtpReport(7000, 144))
      .mockResolvedValue(rtpReport(8000, 168));
    const sources = () => [{ participantId: 'peer', identity: getStats, getStats }];
    const firstPublish = vi.fn();
    const first = new StatsCollector(sources, firstPublish);
    await vi.advanceTimersByTimeAsync(1000);
    expect(firstPublish.mock.lastCall?.[0].get('peer').inboundBitrate).toBe(192);
    first.close();
    await vi.advanceTimersByTimeAsync(4000);
    expect(getStats).toHaveBeenCalledTimes(2);
    const publish = vi.fn();
    const next = new StatsCollector(sources, publish);
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.lastCall?.[0].get('peer').inboundBitrate).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish.mock.lastCall?.[0].get('peer').inboundBitrate).toBe(192);
    next.close();
  });

  it('clears the baseline on non-advancing or missing report timestamps', async () => {
    vi.useFakeTimers();
    const getStats = vi
      .fn()
      .mockResolvedValueOnce(rtpReport(1000, 0))
      .mockResolvedValueOnce(rtpReport(1000, 24))
      .mockResolvedValueOnce(rtpReport(2000, 48))
      .mockResolvedValueOnce(rtpReport(1500, 60))
      .mockResolvedValueOnce(rtpReport(Number.NaN, 72))
      .mockResolvedValueOnce(rtpReport(4000, 96))
      .mockResolvedValue(rtpReport(5000, 120));
    const publish = vi.fn();
    const collector = new StatsCollector(
      () => [{ participantId: 'peer', identity: getStats, getStats }],
      publish,
    );
    for (let index = 0; index < 6; index++) {
      await vi.advanceTimersByTimeAsync(index ? 1000 : 0);
      expect(publish.mock.lastCall?.[0].get('peer').inboundBitrate).toBeNull();
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish.mock.lastCall?.[0].get('peer').inboundBitrate).toBe(192);
    collector.close();
  });
  it('publishes first-sample nulls, polls once a second, and stops on close', async () => {
    vi.useFakeTimers();
    const getStats = vi
      .fn()
      .mockResolvedValueOnce(rtpReport(1000, 0))
      .mockResolvedValue(rtpReport(2000, 24));
    const publish = vi.fn();
    const collector = new StatsCollector(
      () => [{ participantId: 'peer', getStats, identity: getStats }],
      publish,
    );
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
    let sources: readonly PeerStatsSource[] = [
      { participantId: 'peer', getStats, identity: getStats },
    ];
    const publish = vi.fn();
    const collector = new StatsCollector(() => sources, publish);
    await vi.advanceTimersByTimeAsync(0);
    sources = [];
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish.mock.lastCall?.[0].size).toBe(0);
    sources = [{ participantId: 'peer', getStats, identity: getStats }];
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
        { participantId: 'failing', getStats: failing, identity: failing },
        { participantId: 'healthy', getStats: healthy, identity: healthy },
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
    const collector = new StatsCollector(
      () => [{ participantId: 'peer', getStats, identity: getStats }],
      publish,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(getStats).toHaveBeenCalledOnce();
    publish.mockClear();
    collector.close();
    resolve(rtpReport(1000, 0));
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
