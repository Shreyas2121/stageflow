export type StatsSample = {
  /** Sample time in milliseconds, as supplied by getStats(). */
  timestamp: number;
  bytesSent: number | null;
  bytesReceived: number | null;
  packetsLost: number | null;
  packetsReceived: number | null;
  jitter: number | null;
  currentRoundTripTime: number | null;
  framesDecoded: number | null;
  localCandidateType: string | null;
};

export type StatsView = {
  /** Bitrates are bits per second. */
  outboundBitrate: number | null;
  inboundBitrate: number | null;
  packetLossPercent: number | null;
  jitterMs: number | null;
  roundTripTimeMs: number | null;
  framesPerSecond: number | null;
  iceType: 'host' | 'srflx' | 'relay' | 'unknown';
};

function counterDelta(previous: number | null, next: number | null): number | null {
  if (previous === null || next === null || next < previous) return null;
  return next - previous;
}

export function deltaStats(previous: StatsSample | null, next: StatsSample): StatsView {
  const seconds = previous === null ? 0 : (next.timestamp - previous.timestamp) / 1000;
  const rate = (before: number | null, after: number | null): number | null => {
    const delta = counterDelta(before, after);
    return seconds > 0 && delta !== null ? delta / seconds : null;
  };
  const outbound = rate(previous?.bytesSent ?? null, next.bytesSent);
  const inbound = rate(previous?.bytesReceived ?? null, next.bytesReceived);
  const lost = counterDelta(previous?.packetsLost ?? null, next.packetsLost);
  const received = counterDelta(previous?.packetsReceived ?? null, next.packetsReceived);
  const candidate = next.localCandidateType;

  return {
    outboundBitrate: outbound === null ? null : outbound * 8,
    inboundBitrate: inbound === null ? null : inbound * 8,
    packetLossPercent:
      lost !== null && received !== null && lost + received > 0
        ? (lost / (lost + received)) * 100
        : null,
    jitterMs: next.jitter === null ? null : next.jitter * 1000,
    roundTripTimeMs: next.currentRoundTripTime === null ? null : next.currentRoundTripTime * 1000,
    framesPerSecond: rate(previous?.framesDecoded ?? null, next.framesDecoded),
    iceType:
      candidate === 'host' || candidate === 'srflx' || candidate === 'relay'
        ? candidate
        : 'unknown',
  };
}
