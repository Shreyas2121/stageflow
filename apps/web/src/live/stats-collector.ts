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
    timestamp: timestamp ?? performance.now(),
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

export class StatsCollector {
  private previous = new Map<string, StatsSample>();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private polling = false;

  constructor(
    private connections: () => readonly PeerStatsSource[],
    private publish: (stats: ConnectionStats) => void,
  ) {
    this.timer = setInterval(() => void this.poll(), 1000);
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const sources = this.connections();
      const ids = new Set(sources.map((source) => source.socketId));
      for (const id of this.previous.keys()) {
        if (!ids.has(id)) this.previous.delete(id);
      }
      const rows = await Promise.all(
        sources.map(async ({ socketId, getStats }) => {
          try {
            const sample = statsSample(await getStats());
            if (this.closed) return null;
            const view = deltaStats(this.previous.get(socketId) ?? null, sample);
            this.previous.set(socketId, sample);
            return [socketId, view] as const;
          } catch {
            // A closing connection or an unavailable report must not retain old rates.
            this.previous.delete(socketId);
            return [socketId, deltaStats(null, statsSample(new Map()))] as const;
          }
        }),
      );
      if (this.closed) return;
      const currentIds = new Set(this.connections().map((source) => source.socketId));
      for (const id of this.previous.keys()) {
        if (!currentIds.has(id)) this.previous.delete(id);
      }
      this.publish(
        new Map(
          rows.filter(
            (row): row is readonly [string, StatsView] => row !== null && currentIds.has(row[0]),
          ),
        ),
      );
    } finally {
      this.polling = false;
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.previous.clear();
  }
}
