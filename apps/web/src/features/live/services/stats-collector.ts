import { deltaStats, type StatsSample, type StatsView } from '@stageflow/shared';
import type { PeerStatsSource } from './peer-manager';

export type ConnectionStats = ReadonlyMap<string, StatsView>;
type LocalCandidateStats = RTCStats & { candidateType?: string };

function sum(values: (number | undefined)[]): number | null {
  const present = values.filter((value): value is number => Number.isFinite(value));
  return present.length ? present.reduce((total, value) => total + value, 0) : null;
}

export function statsSample(report: RTCStatsReport): StatsSample {
  const inbound: RTCInboundRtpStreamStats[] = [];
  const outbound: RTCOutboundRtpStreamStats[] = [];
  const pairs: RTCIceCandidatePairStats[] = [];
  const selectedPairs = new Set<string>();
  const candidates = new Map<string, LocalCandidateStats>();
  let timestamp: number | null = null;
  report.forEach((entry: RTCStats) => {
    if (Number.isFinite(entry.timestamp)) timestamp = Math.max(timestamp ?? 0, entry.timestamp);
    switch (entry.type) {
      case 'inbound-rtp':
        inbound.push(entry as RTCInboundRtpStreamStats);
        break;
      case 'outbound-rtp':
        outbound.push(entry as RTCOutboundRtpStreamStats);
        break;
      case 'candidate-pair':
        pairs.push(entry as RTCIceCandidatePairStats);
        break;
      case 'local-candidate':
        candidates.set(entry.id, entry as LocalCandidateStats);
        break;
      case 'transport': {
        const selected = (entry as RTCTransportStats).selectedCandidatePairId;
        if (selected) selectedPairs.add(selected);
        break;
      }
    }
  });
  const nominated = pairs.filter((pair) => pair.nominated && pair.state === 'succeeded');
  const pair = nominated.find((pair) => selectedPairs.has(pair.id)) ?? nominated[0];
  const audio = inbound.find((entry) => entry.kind === 'audio' && Number.isFinite(entry.jitter));
  const video = inbound.find((entry) => entry.kind === 'video' && Number.isFinite(entry.jitter));

  return {
    timestamp: timestamp ?? Number.NaN,
    bytesSent: sum(outbound.map((entry) => entry.bytesSent)),
    bytesReceived: sum(inbound.map((entry) => entry.bytesReceived)),
    packetsLost: sum(inbound.map((entry) => entry.packetsLost)),
    packetsReceived: sum(inbound.map((entry) => entry.packetsReceived)),
    jitter: audio?.jitter ?? video?.jitter ?? null,
    currentRoundTripTime: pair?.currentRoundTripTime ?? null,
    framesDecoded: sum(
      inbound.filter((entry) => entry.kind === 'video').map((entry) => entry.framesDecoded),
    ),
    localCandidateType: pair
      ? (candidates.get(pair.localCandidateId)?.candidateType ?? null)
      : null,
  };
}

export const STATS_POLL_INTERVAL_MS = 1000;
export const STATS_READ_TIMEOUT_MS = 800;

type PendingRead = { deliver: ((report: RTCStatsReport | null) => void) | null };
// One native read per connection, including across drawer close/reopen. A native
// getStats promise cannot be cancelled. Expired reads have no waiting collector.
const pendingReads = new WeakMap<object, PendingRead>();
function observeRead(source: PeerStatsSource, pending: PendingRead): void {
  const settle = (report: RTCStatsReport | null) => {
    if (pendingReads.get(source.identity) === pending) pendingReads.delete(source.identity);
    pending.deliver?.(report);
  };
  void Promise.resolve()
    .then(source.getStats)
    .then(settle, () => settle(null));
}

export class StatsCollector {
  private previous = new Map<string, { identity: object; sample: StatsSample }>();
  private readonly cancelReads = new Set<() => void>();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private polling = false;

  constructor(
    private connections: () => readonly PeerStatsSource[],
    private publish: (stats: ConnectionStats) => void,
  ) {
    this.timer = setInterval(() => void this.poll(), STATS_POLL_INTERVAL_MS);
    void this.poll();
  }

  private read(source: PeerStatsSource): Promise<RTCStatsReport | null> {
    if (pendingReads.has(source.identity)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const pending: PendingRead = { deliver: null };
      const finish = (report: RTCStatsReport | null) => {
        clearTimeout(timer);
        this.cancelReads.delete(cancel);
        pending.deliver = null;
        resolve(report);
      };
      const cancel = () => finish(null);
      const timer = setTimeout(cancel, STATS_READ_TIMEOUT_MS);
      this.cancelReads.add(cancel);
      pending.deliver = finish;
      pendingReads.set(source.identity, pending);
      observeRead(source, pending);
    });
  }

  private async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const sources = this.connections();
      const identities = new Map(sources.map((source) => [source.participantId, source.identity]));
      for (const [id, baseline] of this.previous) {
        if (identities.get(id) !== baseline.identity) this.previous.delete(id);
      }
      const rows = await Promise.all(
        sources.map(async (source) => {
          const report = await this.read(source);
          if (this.closed) return null;
          const sample = report ? statsSample(report) : null;
          const previous = this.previous.get(source.participantId)?.sample;
          if (
            !sample ||
            !Number.isFinite(sample.timestamp) ||
            (previous && sample.timestamp <= previous.timestamp)
          ) {
            this.previous.delete(source.participantId);
            return [source.participantId, deltaStats(null, statsSample(new Map()))] as const;
          }
          const view = deltaStats(previous ?? null, sample);
          this.previous.set(source.participantId, { identity: source.identity, sample });
          return [source.participantId, view] as const;
        }),
      );
      if (this.closed) return;
      const current = new Map(
        this.connections().map((source) => [source.participantId, source.identity]),
      );
      for (const [id, baseline] of this.previous) {
        if (current.get(id) !== baseline.identity) this.previous.delete(id);
      }
      this.publish(
        new Map(
          rows.filter(
            (row): row is readonly [string, StatsView] =>
              row !== null && current.get(row[0]) === identities.get(row[0]),
          ),
        ),
      );
    } finally {
      this.polling = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const cancel of this.cancelReads) cancel();
    this.previous.clear();
  }
}
